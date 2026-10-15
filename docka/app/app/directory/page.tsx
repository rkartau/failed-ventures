import Link from "next/link";
import { auth } from "@/auth";
import { searchDirectory, type DirectoryRow } from "@/lib/directory";
import { DirectorySearch } from "@/components/DirectorySearch";
import { SurfaceRefSaltMissing } from "@/lib/surface-ref";

// isolation-guard: exempt — the directory resolves NO agent/seaman tenant identity
// (auth() only). It is a narrow cross-tenant reader gated by dual+live consent inside
// lib/directory, returning ONLY projected rows.
export const dynamic = "force-dynamic";

// noindex the directory (R49.9): honest opt-in never means public search-indexing.
export const metadata = { robots: { index: false, follow: false } };

function SignInPrompt() {
  return (
    <div className="mx-auto max-w-2xl px-4 py-20 text-center" data-testid="directory-signin">
      <meta name="robots" content="noindex,nofollow" />
      <h1 className="text-2xl font-bold text-slate-900">docka-verified directory</h1>
      <p className="mt-2 text-slate-500">
        Sign in as a shipowner / client to browse identity-verified seafarers who chose to be listed.
      </p>
      <Link
        href="/api/auth/signin"
        className="mt-6 inline-block rounded-xl bg-brand-600 px-5 py-2.5 text-sm font-semibold text-white hover:bg-brand-700"
      >
        Sign in
      </Link>
    </div>
  );
}

export default async function DirectoryPage() {
  const session = await auth();
  if (!session?.user?.email) return <SignInPrompt />;

  let rows: DirectoryRow[] = [];
  try {
    const res = searchDirectory({});
    if (res.ok) rows = res.rows;
  } catch (e) {
    if (e instanceof SurfaceRefSaltMissing) {
      return (
        <div className="mx-auto max-w-2xl px-4 py-20 text-center">
          <meta name="robots" content="noindex,nofollow" />
          <h1 className="text-2xl font-bold text-slate-900">Temporarily unavailable</h1>
          <p className="mt-2 text-slate-500">The directory cannot be shown right now. Please try again later.</p>
        </div>
      );
    }
    throw e;
  }

  return (
    <div className="mx-auto max-w-3xl px-4 py-10" data-testid="directory-page">
      <meta name="robots" content="noindex,nofollow" />
      <h1 className="text-2xl font-bold text-slate-900">docka-verified directory</h1>
      <p className="mt-1 text-sm text-slate-500">
        Identity-verified seafarers who chose to be listed. You see their name, rank,
        issuing country and verification level — enquire through their agency. A
        &ldquo;verified&rdquo; identity is not the same as sea-readiness; check the expiry
        counts.
      </p>
      <div className="mt-6">
        <DirectorySearch initialRows={rows} />
      </div>
    </div>
  );
}
