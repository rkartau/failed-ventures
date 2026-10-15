import { NextRequest, NextResponse } from "next/server";
import { agentSession } from "@/lib/agent-session";
import { requireBillingReadable, requireBillingWritable } from "@/lib/billing-enforce";
import {
  createVacancy,
  updateVacancy,
  closeVacancy,
  listVacancies,
} from "@/lib/vacancy-store";

export const dynamic = "force-dynamic";

// #52 — agent-only vacancy CRUD.
//   GET   /api/vacancies                          -> own vacancies
//   POST  /api/vacancies {title, rank, ...}       -> create (idempotent on createKey)
//   PATCH /api/vacancies {id, action?:"close", ...}
//
// isolation-guard: exempt — vacancy rows are partitioned by agentId in
// lib/vacancy-store (owner-scoped create/update/close/list). This CRUD route reads NO
// cross-tenant seafarer/document data; the matching page (agent/vacancies) does that,
// through the grant-scoped listSeafarersForAgent + getDocumentsForAgent guards.

export async function GET() {
  const session = await agentSession();
  const billingGate = requireBillingReadable(session);
  if (!billingGate.ok) return billingGate.response;
  if (!session?.user) return NextResponse.json({ ok: false, error: "Sign in." }, { status: 401 });
  return NextResponse.json({ ok: true, vacancies: listVacancies(session.agentId) });
}

export async function POST(req: NextRequest) {
  const session = await agentSession();
  const billingGate = requireBillingWritable(session);
  if (!billingGate.ok) return billingGate.response;
  if (!session?.user) return NextResponse.json({ ok: false, error: "Sign in." }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const res = await createVacancy(session.agentId, {
    title: body.title as string | undefined,
    rank: body.rank as string | undefined,
    vesselType: (body.vesselType as string | null | undefined) ?? null,
    flagState: (body.flagState as string | null | undefined) ?? null,
    requiredCerts: body.requiredCerts,
    requiredEndorsements: body.requiredEndorsements,
    minSeaDays: body.minSeaDays,
    seaWindowMonths: body.seaWindowMonths,
    rotationEnd: (body.rotationEnd as string | null | undefined) ?? null,
    createKey: (body.createKey as string | null | undefined) ?? null,
  });
  if (!res.ok) return NextResponse.json({ ok: false, error: res.error }, { status: 400 });
  return NextResponse.json({ ok: true, vacancy: res.vacancy });
}

export async function PATCH(req: NextRequest) {
  const session = await agentSession();
  const billingGate = requireBillingWritable(session);
  if (!billingGate.ok) return billingGate.response;
  if (!session?.user) return NextResponse.json({ ok: false, error: "Sign in." }, { status: 401 });
  const body = (await req.json().catch(() => ({}))) as Record<string, unknown>;
  const vacancyId = String(body.id ?? "").trim();
  if (!vacancyId) return NextResponse.json({ ok: false, error: "id is required." }, { status: 400 });
  const res =
    body.action === "close"
      ? await closeVacancy(session.agentId, vacancyId)
      : await updateVacancy(session.agentId, vacancyId, {
          title: body.title as string | undefined,
          rank: body.rank as string | undefined,
          vesselType: body.vesselType as string | null | undefined,
          flagState: body.flagState as string | null | undefined,
          requiredCerts: body.requiredCerts,
          requiredEndorsements: body.requiredEndorsements,
          minSeaDays: body.minSeaDays,
          seaWindowMonths: body.seaWindowMonths,
          rotationEnd: body.rotationEnd as string | null | undefined,
          status: body.status as "open" | "filled" | "closed" | undefined,
        });
  if (!res.ok) return NextResponse.json({ ok: false, error: res.error }, { status: 404 });
  return NextResponse.json({ ok: true, vacancy: res.vacancy });
}
