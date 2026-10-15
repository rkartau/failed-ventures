// SERVER-side persistence for the per-agent required-docs config. Kept OUT of
// lib/required-docs.ts (which must stay client-safe / Node-free so UI components
// can import the pure engine). Everything here touches db.json through the shared
// mutex (updateDB), so a config edit is atomic and single-writer, same as every
// other mutation.

import {
  readDB,
  updateDB,
  id,
  AUDIT_NO_IMPERSONATION,
  type RequiredDocsAuditRow,
  type AuditOnBehalf,
} from "@/lib/db";
import {
  defaultConfigFor,
  sanitizeConfig,
  RANK_KEYS,
  RANK_LABELS,
  VESSEL_TYPE_KEYS,
  VESSEL_TYPE_LABELS,
  FLAG_KEYS,
  FLAG_LABELS,
  type RequiredDocsConfig,
  type RankKey,
  type VesselTypeKey,
  type FlagKey,
} from "@/lib/required-docs";
import type { RequiredDocType } from "@/lib/doctypes";

/**
 * The agent's stored config, or a fresh default (baseline) when they have never
 * edited one. Pure read — does NOT persist the default, so an unedited agent is
 * always in lock-step with the current baseline.
 */
export function getConfigForAgent(agentId: string): RequiredDocsConfig {
  const db = readDB();
  const found = db.requiredDocsConfigs.find((c) => c.agentId === agentId);
  return found ?? defaultConfigFor(agentId);
}

/** True when the agent has explicitly saved a config (vs. running on the default). */
export function hasCustomConfig(agentId: string): boolean {
  return readDB().requiredDocsConfigs.some((c) => c.agentId === agentId);
}

/**
 * Seafarer ids this agent's config governs — the BLAST RADIUS of a config edit.
 * An edit applies to ALL the agent's seafarers, so this is the set the settings
 * page reports and each audit row records. Uses the grant scope when the agent has
 * grants; falls back to the whole roster (the single-tenant dev/demo reality where
 * the board shows every seafarer) so the number is honest rather than a misleading
 * zero.
 */
export function governedSeafarerIds(agentId: string): string[] {
  const db = readDB();
  const granted = new Set<string>();
  for (const g of db.accessGrants) {
    if (g.agentId === agentId && (g.status === "ACTIVE")) granted.add(g.seafarerId);
  }
  if (granted.size > 0) return [...granted];
  return db.seafarers.map((s) => s.id);
}

function labelList(arr: RequiredDocType[]): string {
  return arr.length ? arr.join(", ") : "none";
}

// Human diff between two configs, for the audit row summary.
function diffSummary(prev: RequiredDocsConfig, next: RequiredDocsConfig): string {
  const parts: string[] = [];
  const setDiff = (a: RequiredDocType[], b: RequiredDocType[]) => {
    const added = b.filter((x) => !a.includes(x));
    const removed = a.filter((x) => !b.includes(x));
    return { added, removed };
  };
  const uni = setDiff(prev.universalRequired, next.universalRequired);
  if (uni.added.length || uni.removed.length) {
    parts.push(
      `Universal: ${uni.added.map((x) => `+${x}`).concat(uni.removed.map((x) => `-${x}`)).join(", ")}`
    );
  }
  for (const k of RANK_KEYS) {
    const d = setDiff(prev.perRankRequired[k] ?? [], next.perRankRequired[k] ?? []);
    if (d.added.length || d.removed.length) {
      parts.push(
        `${RANK_LABELS[k]}: ${d.added.map((x) => `+${x}`).concat(d.removed.map((x) => `-${x}`)).join(", ")}`
      );
    }
  }
  for (const k of VESSEL_TYPE_KEYS) {
    const d = setDiff(prev.perVesselTypeRequired?.[k] ?? [], next.perVesselTypeRequired?.[k] ?? []);
    if (d.added.length || d.removed.length) {
      parts.push(
        `${VESSEL_TYPE_LABELS[k]}: ${d.added.map((x) => `+${x}`).concat(d.removed.map((x) => `-${x}`)).join(", ")}`
      );
    }
  }
  for (const k of FLAG_KEYS) {
    const d = setDiff(prev.perFlagRequired?.[k] ?? [], next.perFlagRequired?.[k] ?? []);
    if (d.added.length || d.removed.length) {
      parts.push(
        `${FLAG_LABELS[k]}: ${d.added.map((x) => `+${x}`).concat(d.removed.map((x) => `-${x}`)).join(", ")}`
      );
    }
  }
  return parts.length ? parts.join(" · ") : "no effective change";
}

/**
 * Save an agent's config edit. Sanitises the input (only real doc types, all rank
 * keys present), UPSERTS the single row for the agent, and appends ONE audit row
 * carrying the human diff + the blast radius (count + ids). Returns the saved
 * config + the audit row. All inside the shared mutex critical section.
 */
export function saveConfigForAgent(
  input: {
    agentId: string;
    actor: string | null;
    universalRequired?: unknown;
    perRankRequired?: Partial<Record<RankKey, unknown>>;
    perVesselTypeRequired?: Partial<Record<VesselTypeKey, unknown>>;
    perFlagRequired?: Partial<Record<FlagKey, unknown>>;
    baselineVersion?: string;
  },
  onBehalf: AuditOnBehalf = AUDIT_NO_IMPERSONATION
): Promise<{ config: RequiredDocsConfig; audit: RequiredDocsAuditRow }> {
  const nowIso = new Date().toISOString();
  return updateDB((db) => {
    const prev =
      db.requiredDocsConfigs.find((c) => c.agentId === input.agentId) ??
      defaultConfigFor(input.agentId);
    const next = sanitizeConfig(
      input.agentId,
      {
        universalRequired: input.universalRequired as RequiredDocType[] | undefined,
        perRankRequired: input.perRankRequired as Record<RankKey, RequiredDocType[]> | undefined,
        perVesselTypeRequired: input.perVesselTypeRequired as Record<VesselTypeKey, RequiredDocType[]> | undefined,
        perFlagRequired: input.perFlagRequired as Record<FlagKey, RequiredDocType[]> | undefined,
        baselineVersion: input.baselineVersion,
      },
      input.actor,
      nowIso
    );

    const idx = db.requiredDocsConfigs.findIndex((c) => c.agentId === input.agentId);
    if (idx >= 0) db.requiredDocsConfigs[idx] = next;
    else db.requiredDocsConfigs.push(next);

    // Blast radius: the agent's governed seafarers at edit time.
    const granted = new Set<string>();
    for (const g of db.accessGrants) {
      if (g.agentId === input.agentId && g.status === "ACTIVE") granted.add(g.seafarerId);
    }
    const affectedIds =
      granted.size > 0 ? [...granted] : db.seafarers.map((s) => s.id);

    const audit: RequiredDocsAuditRow = {
      id: id(),
      agentId: input.agentId,
      at: nowIso,
      actor: input.actor ?? "Agent",
      summary: diffSummary(prev, next),
      affectedSeafarers: affectedIds.length,
      affectedSeafarerIds: affectedIds,
      // Impersonation attribution (F1): this row is NOT a chained sink, so the stamp
      // is written directly onto the row fields (mirrors the appendAuditRaw merge).
      ...(onBehalf === AUDIT_NO_IMPERSONATION ? {} : onBehalf),
    };
    db.requiredDocsAudit.push(audit);
    return { config: next, audit };
  });
}

/** This agent's config-edit audit rows, newest first. */
export function auditForAgent(agentId: string): RequiredDocsAuditRow[] {
  return readDB()
    .requiredDocsAudit.filter((r) => r.agentId === agentId)
    .sort((a, b) => b.at.localeCompare(a.at));
}

export { labelList };
