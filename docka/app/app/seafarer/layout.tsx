import type { Metadata } from "next";

// NOINDEX the seafarer dossier. NOTE: app/app/seafarer/page.tsx is a "use client"
// component, which cannot export `metadata` — so the noindex lives in this segment
// layout instead of a page-level export. Kept crawlable (no robots.txt disallow).
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function SeafarerLayout({ children }: { children: React.ReactNode }) {
  return children;
}
