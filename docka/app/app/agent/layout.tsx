import type { Metadata } from "next";

// TS2: noindex the ENTIRE agent area via a segment LAYOUT so it cascades to every
// nested + dynamic route (/agent/[id], /agent/search, /agent/analytics,
// /agent/settings/*, …). A page-only export would leave nested segments indexable.
// Kept CRAWLABLE (no robots.txt disallow) so crawlers can see this noindex.
export const metadata: Metadata = {
  robots: { index: false, follow: false },
};

export default function AgentLayout({ children }: { children: React.ReactNode }) {
  return children;
}
