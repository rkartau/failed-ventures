// Global, server-driven impersonation banner. Mounted in the ROOT layout so it shows
// on EVERY page (including the tenant surfaces /seafarer and /agent — the admin
// surface's own layout would not cover those). Tri-state (F3 + F4 mitigation):
//   * active    → high-contrast "Viewing as <name> · admin <email> · Exit" bar.
//   * suspended → "Impersonation expired — Exit to resume admin" bar (the recovery
//                 affordance for the F3 403 state; tenant routes 403 until Exit).
//   * none / non-admin / anonymous → renders nothing.
//
// This is a server component; adminSession() returns null cleanly for a logged-out or
// non-admin session (no throw, no leak), so the per-page check is safe. Not a routable
// module and lives outside app/admin, so it is never scanned by the isolation guard.
import { adminSession } from "@/lib/admin-session";
import { resolveImpersonation } from "@/lib/impersonation";
import { readDB } from "@/lib/db";
import { ExitImpersonationButton } from "./ExitImpersonationButton";

export async function ImpersonationBanner(): Promise<JSX.Element | null> {
  const admin = await adminSession();
  if (!admin) return null;
  const email = (admin.user.email ?? "").trim().toLowerCase();
  const res = resolveImpersonation(email);

  if (res.state === "suspended") {
    return (
      <div className="flex items-center justify-center bg-amber-600 px-4 py-2 text-center text-sm font-medium text-white">
        <span>Impersonation expired — Exit to resume admin.</span>
        <ExitImpersonationButton label="Exit to resume admin" />
      </div>
    );
  }

  if (res.state === "active") {
    const db = readDB();
    const name =
      res.record.targetKind === "seaman"
        ? db.seafarers.find((s) => s.id === res.record.targetId)?.name ?? res.record.targetId
        : db.agents.find((a) => a.id === res.record.targetId)?.orgName ?? res.record.targetId;
    return (
      <div className="flex items-center justify-center bg-rose-700 px-4 py-2 text-center text-sm font-medium text-white">
        <span>
          Viewing as <span className="font-bold">{name}</span> · signed in as admin{" "}
          <span className="font-mono">{email}</span>
        </span>
        <ExitImpersonationButton />
      </div>
    );
  }

  return null;
}
