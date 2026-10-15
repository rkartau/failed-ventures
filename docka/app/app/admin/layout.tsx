// app/admin/layout.tsx
//
// Layer C (authoritative) gate for the WHOLE admin surface + a thin admin nav.
// Every admin page ALSO re-checks adminSession() itself (pages are the isolation
// unit in this codebase — a layout is not a substitute), but gating here fails
// closed before any admin chrome renders.
//
// force-dynamic: the gate must run per request, never be statically cached.

import Link from "next/link";
import { readFile } from "node:fs/promises";
import { join } from "node:path";
import { adminSession } from "@/lib/admin-session";
import { adminDeniedResponse } from "./access";
import { DeploySkewBar } from "./deploy-skew";
import { NAV_GROUPS, NAV_STANDALONE } from "./nav";

export const dynamic = "force-dynamic";

/** Deployed commit SHA (public/version.txt, same source as /api/version). */
async function deployedSha(): Promise<string> {
  try {
    return (await readFile(join(process.cwd(), "public", "version.txt"), "utf8")).trim();
  } catch {
    return "unknown"; // local dev — DeploySkewBar renders nothing
  }
}

export default async function AdminLayout({
  children,
}: {
  children: React.ReactNode;
}): Promise<JSX.Element> {
  const session = await adminSession();
  if (!session) {
    // Signed out → sign-in prompt; signed in but not allowlisted → notFound().
    return await adminDeniedResponse();
  }

  return (
    <div className="min-h-screen bg-slate-50">
      {/* Deploy-skew hint: compares the SHA this page rendered with against
          /api/version every 5 min; shows a one-line reload bar on mismatch. */}
      <DeploySkewBar renderedSha={await deployedSha()} />
      <header className="border-b border-slate-200 bg-white">
        <div className="mx-auto flex max-w-6xl flex-wrap items-center justify-between gap-3 px-4 py-3">
          <div className="flex flex-wrap items-center gap-x-4 gap-y-2">
            <span className="text-sm font-bold text-slate-900">docka admin</span>
            {/* Always-visible, labeled clusters (RV7). The nav is DATA in ./nav so
                the grouping is one source of truth and unit-testable. */}
            <nav className="flex flex-wrap items-center gap-x-4 gap-y-2 text-sm">
              {NAV_GROUPS.map((grp, gi) => (
                <div
                  key={grp.group}
                  className={`flex flex-wrap items-center gap-x-3 gap-y-1 ${
                    gi > 0 ? "border-l border-slate-200 pl-4" : ""
                  }`}
                >
                  <span className="text-[11px] uppercase tracking-wide text-slate-400">
                    {grp.group}
                  </span>
                  {grp.items.map((it) => (
                    <Link
                      key={it.href}
                      href={it.href}
                      className="text-slate-600 hover:text-slate-900"
                    >
                      {it.label}
                    </Link>
                  ))}
                </div>
              ))}
              {NAV_STANDALONE.map((it) => (
                <div key={it.href} className="border-l border-slate-200 pl-4">
                  <Link href={it.href} className="text-slate-600 hover:text-slate-900">
                    {it.label}
                  </Link>
                </div>
              ))}
            </nav>
          </div>
          <span className="text-xs text-slate-400">
            {session.user.email ?? session.user.name ?? "admin"}
          </span>
        </div>
      </header>
      <main>{children}</main>
    </div>
  );
}
