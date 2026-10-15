import { NextResponse } from "next/server";
import { readFile } from "node:fs/promises";
import { join } from "node:path";

// The deployed commit SHA is written to public/version.txt at deploy time
// (see DEPLOY-RUNBOOK.md §B1). Because .git is excluded from the deploy tar,
// this file is the box's only record of which commit is live. Read it at
// request time so the value reflects the running build, not a build-time cache.
export const dynamic = "force-dynamic";
export const runtime = "nodejs";

export async function GET() {
  let sha = "unknown";
  try {
    sha = (await readFile(join(process.cwd(), "public", "version.txt"), "utf8")).trim();
  } catch {
    // marker absent (e.g. local dev with no deploy) — report unknown rather than 500
  }
  return NextResponse.json({ sha });
}
