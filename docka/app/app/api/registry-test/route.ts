import { NextResponse } from "next/server";
import {
  registryJournal,
  registryMockMode,
  resetRegistryAbuseState,
  resetRegistryJournal,
} from "@/lib/registry";
import { updateDB } from "@/lib/db";

export const dynamic = "force-dynamic";

// TEST-ONLY endpoint (plan §6.2) — exists ONLY in mock mode (REGISTRY_MOCK=1
// outside production); anywhere else both verbs 404 exactly like an unknown
// route, so nothing test-shaped is reachable on the Hetzner box.
//
//   GET  /api/registry-test          — journey preflight: asserts the SERVER
//        process is in mock mode and returns the fetchWithGuard request
//        journal (the ONLY valid way to assert "no fetch happened").
//   POST /api/registry-test {action:"reset"} — per-journey reset: clears the
//        journal + result cache + token buckets, so journal assertions are
//        snapshot-deltas from this point.
//   POST /api/registry-test {action:"strip-doc-inputs", documentId} — deletes a
//        doc's stored `registryInputs`, simulating a pre-§4.6 government doc
//        whose lookup inputs were never stored (the §5.4 UK-without-DOB honest-
//        snapshot proof case). Mock mode only, like everything here.

export async function GET() {
  if (!registryMockMode()) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }
  return NextResponse.json({ ok: true, mock: true, journal: registryJournal() });
}

export async function POST(req: Request) {
  if (!registryMockMode()) {
    return NextResponse.json({ ok: false, error: "Not found." }, { status: 404 });
  }
  const body = (await req.json().catch(() => ({}))) as {
    action?: string;
    documentId?: string;
  };
  if (body.action === "reset") {
    resetRegistryJournal();
    resetRegistryAbuseState();
    return NextResponse.json({ ok: true, reset: true });
  }
  if (body.action === "strip-doc-inputs") {
    const documentId = (body.documentId ?? "").trim();
    if (!documentId) {
      return NextResponse.json({ ok: false, error: "documentId required." }, { status: 400 });
    }
    let found = false;
    await updateDB((db) => {
      const doc = db.documents.find((d) => d.id === documentId);
      if (doc) {
        delete doc.registryInputs;
        found = true;
      }
    });
    if (!found) {
      return NextResponse.json({ ok: false, error: "Document not found." }, { status: 404 });
    }
    return NextResponse.json({ ok: true, stripped: true });
  }
  return NextResponse.json({ ok: false, error: "Unknown action." }, { status: 400 });
}
