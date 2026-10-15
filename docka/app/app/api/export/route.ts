import { NextRequest, NextResponse } from "next/server";
import { readDB, type Doc } from "@/lib/db";
import { STATE_LABELS } from "@/lib/pipeline";
import { docStatusForDoc, STATUS_LABELS } from "@/lib/cert";
import { BASE_REQUIRED_DOC_TYPES } from "@/lib/doctypes";
import { assignmentBlockers } from "@/lib/compliance";
import {
  docNumber,
  duplicateNameIndex,
  duplicateOthers,
  type DuplicateNameIndex,
} from "@/lib/duplicates";
import { agentSession } from "@/lib/agent-session";
import { requireBillingReadable } from "@/lib/billing-enforce";
import { listSeafarersForAgent } from "@/lib/agentData";
import { activeDocs } from "@/lib/archive";
import { employmentContextFor, employmentCompleteness } from "@/lib/required-docs";
import type { Assignment } from "@/lib/db";
import { evaluateRestHours, MIN_REST_24H, MIN_REST_7D } from "@/lib/rest-hours";

export const dynamic = "force-dynamic";

function csvCell(v: unknown): string {
  const s = v == null ? "" : String(v);
  return /[",\n]/.test(s) ? `"${s.replace(/"/g, '""')}"` : s;
}

const SOURCE_LABEL: Record<string, string> = {
  government: "Government-verified",
  photo: "Read from photo",
  manual: "Manual / plain file",
};

function csvOut(rows: string[][], filename: string): NextResponse {
  const csv = rows.map((r) => r.map(csvCell).join(",")).join("\r\n");
  const stamp = new Date().toISOString().replace(/[:.]/g, "-").slice(0, 19);
  return new NextResponse(csv, {
    status: 200,
    headers: {
      "Content-Type": "text/csv; charset=utf-8",
      "Content-Disposition": `attachment; filename="${filename}-${stamp}.csv"`,
      "Cache-Control": "no-store",
    },
  });
}

function docRow(
  sName: string,
  rank: string,
  vessel: string,
  state: string,
  seaReady: string,
  required: string,
  d: Doc | null,
  dupIndex: DuplicateNameIndex
): string[] {
  if (!d) {
    return [sName, rank, vessel, state, seaReady, required, "", "", "MISSING", "", "", "MISSING", "", "", "", ""];
  }
  const others = duplicateOthers(d, dupIndex, sName);
  return [
    sName,
    rank,
    vessel,
    state,
    seaReady,
    required,
    d.title,
    SOURCE_LABEL[d.source] ?? d.source,
    d.reviewStatus,
    d.reviewedBy ?? "",
    d.reviewedAt ?? "",
    // Feature 3 — a perpetual (no-expiry) doc reads "No expiry", not "Expiry unknown".
    STATUS_LABELS[docStatusForDoc(d)],
    d.noExpiry ? "No expiry" : d.validUntil ?? "",
    d.estonianCode ?? "",
    docNumber(d),
    others.length ? `DUPLICATE with ${others.join(" / ")}` : "",
  ];
}

function safeSeaReady(reasons: string[]): string {
  if (!reasons.length) return "Yes";
  return `NO — ${reasons.join("; ")}`;
}

// GET /api/export
//   (default)             -> crew certificate CSV (one row per seafarer × required type)
//   ?report=rest-hours    -> STCW/MLC rest-hours CSV with ILO work/rest violations
//
// Both require an authenticated agent (this is office crew data). Medical gating is
// OFF (owner D3): health data is included in full for a signed-in agent.
export async function GET(req: NextRequest) {
  const session = await agentSession();
  const billingGate = requireBillingReadable(session);
  if (!billingGate.ok) return billingGate.response;
  if (!session?.user) {
    return NextResponse.json(
      { ok: false, error: "Sign in as an agent to export crew data." },
      { status: 401 }
    );
  }

  const db = readDB();
  const report = req.nextUrl.searchParams.get("report");
  const kind = req.nextUrl.searchParams.get("kind");

  // ---- Employment doc-set (#41 item 17) — N+1-safe, deterministic order ----
  if (kind === "employment") {
    // Build the per-seafarer indexes ONCE per request (no per-row full scan).
    const docsBySeafarer = new Map<string, Doc[]>();
    for (const d of db.documents) {
      const list = docsBySeafarer.get(d.seafarerId);
      if (list) list.push(d);
      else docsBySeafarer.set(d.seafarerId, [d]);
    }
    // Only THIS agent's LIVE assignments count toward "assigned".
    const liveAssignmentsBySeafarer = new Map<string, Assignment[]>();
    for (const a of db.assignments) {
      if (a.agentId !== session.agentId || a.returnedAt !== null) continue;
      const list = liveAssignmentsBySeafarer.get(a.seafarerId);
      if (list) list.push(a);
      else liveAssignmentsBySeafarer.set(a.seafarerId, [a]);
    }
    const has = (docs: Doc[], slot: string): string =>
      docs.some((d) => d.requiredType === slot) ? "present" : "missing";
    const seaStatus = (ec: ReturnType<typeof employmentCompleteness>, docs: Doc[]): string => {
      if (!ec.applicable) return "n/a (benched)";
      if (ec.missing.includes("SEA")) return "missing";
      if (ec.expired.includes("SEA")) return "expired";
      if (ec.unknownExpiry.includes("SEA")) return "unknown expiry";
      return docs.some((d) => d.requiredType === "SEA") ? "present" : "missing";
    };
    const header = [
      "Seafarer",
      "Rank",
      "Vessel",
      "Assigned",
      "SEA",
      "WageAccount",
      "Allotment",
      "ContractAddendum",
      "CBAClaimed",
    ];
    const rows: string[][] = [header];
    // DETERMINISTIC order: listSeafarersForAgent's stable order — NOT re-sorted.
    for (const s of listSeafarersForAgent(session.agentId, false)) {
      const docs = activeDocs(docsBySeafarer.get(s.id) ?? []);
      const assigned = (liveAssignmentsBySeafarer.get(s.id) ?? []).length > 0;
      const ctx = employmentContextFor(s);
      const ec = employmentCompleteness(docs.map((d) => d.requiredType), docs, ctx, { assigned });
      rows.push([
        s.name,
        s.rank,
        s.vessel ?? "(unassigned)",
        assigned ? "yes" : "no",
        seaStatus(ec, docs),
        has(docs, "Wage Account"),
        has(docs, "Allotment"),
        has(docs, "Contract Addendum"),
        ctx.cbaCovered ? `claimed${ctx.cbaRef ? ` (${ctx.cbaRef})` : ""}` : "no",
      ]);
    }
    return csvOut(rows, "employment-docs");
  }

  // The exported ROWS are grant-scoped: only seafarers who granted THIS agent
  // access appear in the CSV (not just the export event). Default-deny via
  // lib/agentData.ts. The cross-seafarer duplicate index stays fleet-wide so a
  // forged/shared cert number is still flagged in the export.
  const nameById = new Map(db.seafarers.map((s) => [s.id, s.name] as const));
  const dupIndex = duplicateNameIndex(db.documents, (id) => nameById.get(id) ?? id);
  const seafarers = listSeafarersForAgent(session.agentId, false).slice().sort((a, b) => {
    const v = (a.vessel ?? "").localeCompare(b.vessel ?? "");
    return v !== 0 ? v : a.name.localeCompare(b.name);
  });

  // ---- Rest-hours (STCW/MLC 2006) report -------------------------------
  if (report === "rest-hours") {
    const header = [
      "Vessel",
      "Seafarer",
      "Rank",
      "Date",
      "RestHours24h",
      "Rest7dRolling",
      `ILOViolation (min ${MIN_REST_24H}h/24h, ${MIN_REST_7D}h/7d)`,
    ];
    const rows: string[][] = [header];
    for (const s of seafarers) {
      const entries = db.restHours.filter((e) => e.seafarerId === s.id);
      const vessel = s.vessel ?? "(unassigned)";
      if (entries.length === 0) {
        rows.push([vessel, s.name, s.rank, "", "", "", "No rest hours logged"]);
        continue;
      }
      const rep = evaluateRestHours(entries);
      for (const d of rep.days) {
        rows.push([
          vessel,
          s.name,
          s.rank,
          d.date,
          String(d.hoursRest),
          d.daysIn7dWindow >= 7 ? String(d.rest7d) : "",
          d.violations.length ? d.violations.join(" | ") : "OK",
        ]);
      }
    }
    return csvOut(rows, "rest-hours-mlc");
  }

  // ---- Default crew certificate CSV ------------------------------------
  const header = [
    "Vessel",
    "Seafarer",
    "Rank",
    "PipelineState",
    "SeaReady",
    "RequiredDocument",
    "DocumentTitle",
    "Source",
    "ReviewStatus",
    "ReviewedBy",
    "ReviewedAt",
    "ExpiryStatus",
    "ValidUntil",
    "RegistryCode",
    "CertNumber",
    "DuplicateFlag",
  ];
  const rows: string[][] = [header];

  for (const s of seafarers) {
    // ACTIVE docs only — archived (retired) docs are not exported as on-file certs.
    const docs = activeDocs(db.documents.filter((d) => d.seafarerId === s.id));
    const state = STATE_LABELS[s.state] ?? s.state;
    const vessel = s.vessel ?? "(unassigned)";
    const block = assignmentBlockers(docs, {
      duplicates: dupIndex,
      ownName: s.name,
      rotationEnd: s.rotationEnd ?? null,
      holderDOB: s.birthDate ?? null,
    });
    const seaReady = safeSeaReady(block.reasons);
    for (const req of BASE_REQUIRED_DOC_TYPES) {
      const match = docs.find((d) => d.requiredType === req) ?? null;
      rows.push(docRow(s.name, s.rank, vessel, state, seaReady, req, match, dupIndex));
    }
    for (const d of docs.filter((d) => !d.requiredType)) {
      rows.push(docRow(s.name, s.rank, vessel, state, seaReady, "Other", d, dupIndex));
    }
  }

  return csvOut(rows, "crew-export");
}
