// #52 — Vacancy persistence (SERVER). Owner-scoped CRUD via `transact`, with
// server-side input validation [C8] and double-submit idempotency on `createKey` in
// ONE critical section [C11]. All the matching maths live in the pure lib/vacancy.ts.

import {
  readDB,
  transact,
  id,
  AUDIT_NO_IMPERSONATION,
  type AuditOnBehalf,
  type Vacancy,
} from "@/lib/db";
import { REQUIRED_DOC_TYPES, type RequiredDocType } from "@/lib/doctypes";
import { serviceDateKey } from "@/lib/sea-service";

const VALID_TYPES = new Set<RequiredDocType>(REQUIRED_DOC_TYPES);
const MAX_TEXT = 120;
const MAX_CERTS = 30;
const MIN_SEA_DAYS_MAX = 25000;
const SEA_WINDOW_MIN = 1;
const SEA_WINDOW_MAX = 600;

function trimCap(v: unknown, cap: number): string {
  return (typeof v === "string" ? v : "").trim().slice(0, cap);
}

// Keep only real doc types, catalog-ordered + de-duplicated, length-capped [C8].
function sanitizeCerts(arr: unknown): RequiredDocType[] {
  if (!Array.isArray(arr)) return [];
  const seen = new Set<RequiredDocType>();
  for (const v of arr) {
    if (typeof v === "string" && VALID_TYPES.has(v as RequiredDocType)) seen.add(v as RequiredDocType);
  }
  return REQUIRED_DOC_TYPES.filter((t) => seen.has(t)).slice(0, MAX_CERTS);
}

// Integer within [lo, hi], or null when absent/blank/unparseable [C8].
function intIn(v: unknown, lo: number, hi: number): number | null {
  if (v == null || v === "") return null;
  const n = Math.floor(Number(v));
  if (!Number.isFinite(n)) return null;
  return Math.min(hi, Math.max(lo, n));
}

function dateOrNull(v: unknown): string | null {
  const k = serviceDateKey(typeof v === "string" ? v : "");
  return k || null;
}

export type CreateVacancyInput = {
  title?: string;
  rank?: string;
  vesselType?: string | null;
  flagState?: string | null;
  requiredCerts?: unknown;
  requiredEndorsements?: unknown;
  minSeaDays?: unknown;
  seaWindowMonths?: unknown;
  rotationEnd?: string | null;
  createKey?: string | null;
};

export type VacancyResult = { ok: true; vacancy: Vacancy } | { ok: false; error: string };

/**
 * Create a vacancy in ONE critical section. Server-side validated [C8]; idempotent on
 * `createKey` [C11] (a create carrying a key already present for this agent returns the
 * existing row). Missing/blank title or rank => 400-shaped error, no row written.
 */
export function createVacancy(
  agentId: string,
  input: CreateVacancyInput,
  onBehalf: AuditOnBehalf = AUDIT_NO_IMPERSONATION
): Promise<VacancyResult> {
  const nowIso = new Date().toISOString();
  const title = trimCap(input.title, MAX_TEXT);
  const rank = trimCap(input.rank, MAX_TEXT);
  const key = (input.createKey ?? "").trim() || null;
  return transact((db): VacancyResult => {
    if (key) {
      const existing = db.vacancies.find((v) => v.agentId === agentId && v.createKey === key);
      if (existing) return { ok: true, vacancy: { ...existing } };
    }
    if (!title || !rank) return { ok: false, error: "title and rank are required" };
    const vacancy: Vacancy = {
      id: id(),
      agentId,
      title,
      rank,
      vesselType: trimCap(input.vesselType, MAX_TEXT) || null,
      flagState: trimCap(input.flagState, MAX_TEXT) || null,
      requiredCerts: sanitizeCerts(input.requiredCerts),
      requiredEndorsements: sanitizeCerts(input.requiredEndorsements),
      minSeaDays: intIn(input.minSeaDays, 0, MIN_SEA_DAYS_MAX),
      seaWindowMonths: intIn(input.seaWindowMonths, SEA_WINDOW_MIN, SEA_WINDOW_MAX),
      rotationEnd: dateOrNull(input.rotationEnd),
      createKey: key,
      status: "open",
      createdAt: nowIso,
      closedAt: null,
    };
    db.vacancies.push(vacancy);
    return { ok: true, vacancy: { ...vacancy } };
  }, onBehalf);
}

export type UpdateVacancyPatch = Partial<CreateVacancyInput> & {
  status?: "open" | "filled" | "closed";
};

/** Owner-scoped update. Foreign / missing id => ok:false (route 404). Validated [C8]. */
export function updateVacancy(
  agentId: string,
  vacancyId: string,
  patch: UpdateVacancyPatch,
  onBehalf: AuditOnBehalf = AUDIT_NO_IMPERSONATION
): Promise<VacancyResult> {
  return transact((db): VacancyResult => {
    const v = db.vacancies.find((x) => x.id === vacancyId && x.agentId === agentId) ?? null;
    if (!v) return { ok: false, error: "not found" };
    if (patch.title !== undefined) {
      const t = trimCap(patch.title, MAX_TEXT);
      if (t) v.title = t;
    }
    if (patch.rank !== undefined) {
      const r = trimCap(patch.rank, MAX_TEXT);
      if (r) v.rank = r;
    }
    if (patch.vesselType !== undefined) v.vesselType = trimCap(patch.vesselType, MAX_TEXT) || null;
    if (patch.flagState !== undefined) v.flagState = trimCap(patch.flagState, MAX_TEXT) || null;
    if (patch.requiredCerts !== undefined) v.requiredCerts = sanitizeCerts(patch.requiredCerts);
    if (patch.requiredEndorsements !== undefined) {
      v.requiredEndorsements = sanitizeCerts(patch.requiredEndorsements);
    }
    if (patch.minSeaDays !== undefined) v.minSeaDays = intIn(patch.minSeaDays, 0, MIN_SEA_DAYS_MAX);
    if (patch.seaWindowMonths !== undefined) {
      v.seaWindowMonths = intIn(patch.seaWindowMonths, SEA_WINDOW_MIN, SEA_WINDOW_MAX);
    }
    if (patch.rotationEnd !== undefined) v.rotationEnd = dateOrNull(patch.rotationEnd);
    if (patch.status === "open" || patch.status === "filled" || patch.status === "closed") {
      v.status = patch.status;
      v.closedAt = patch.status === "open" ? null : v.closedAt ?? new Date().toISOString();
    }
    return { ok: true, vacancy: { ...v } };
  }, onBehalf);
}

/** Owner-scoped close (status => "closed"). Foreign / missing id => ok:false. */
export function closeVacancy(
  agentId: string,
  vacancyId: string,
  onBehalf: AuditOnBehalf = AUDIT_NO_IMPERSONATION
): Promise<VacancyResult> {
  const nowIso = new Date().toISOString();
  return transact((db): VacancyResult => {
    const v = db.vacancies.find((x) => x.id === vacancyId && x.agentId === agentId) ?? null;
    if (!v) return { ok: false, error: "not found" };
    v.status = "closed";
    v.closedAt = nowIso;
    return { ok: true, vacancy: { ...v } };
  }, onBehalf);
}

/** Own-tenant vacancies, newest first. */
export function listVacancies(agentId: string): Vacancy[] {
  return readDB()
    .vacancies.filter((v) => v.agentId === agentId)
    .sort((a, b) => b.createdAt.localeCompare(a.createdAt));
}
